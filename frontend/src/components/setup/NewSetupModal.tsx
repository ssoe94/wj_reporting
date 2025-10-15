import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useLang } from '@/i18n';
import api from '@/lib/api';
import { toast } from 'react-toastify';
import { Autocomplete, TextField } from '@mui/material';
import { usePartSpecSearch } from '@/hooks/usePartSpecs';
import type { PartSpec } from '@/hooks/usePartSpecs';
import { Plus } from 'lucide-react';
import NewPartSpecModal from './NewPartSpecModal'; // Import the new modal

interface NewSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function NewSetupModal({
  isOpen,
  onClose,
  onSuccess
}: NewSetupModalProps) {
  const { t } = useLang();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [formData, setFormData] = useState({
    machine_no: '',
    model_code: '',
    part_no: '',
    target_cycle_time: '',
    note: '',
  });

  const [partNoQuery, setPartNoQuery] = useState('');
  const { data: partSpecResults = [], isLoading: isLoadingPartSpecs } = usePartSpecSearch(partNoQuery);
  const [selectedPartSpec, setSelectedPartSpec] = useState<PartSpec | null>(null);
  const [showAddPartModal, setShowAddPartModal] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // Reset form when modal opens
      setFormData({
        machine_no: '',
        model_code: '',
        part_no: '',
        target_cycle_time: '',
        note: '',
      });
      setError('');
      setPartNoQuery('');
      setSelectedPartSpec(null);
    }
  }, [isOpen]);

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handlePartSpecChange = (partSpec: PartSpec | null) => {
    setSelectedPartSpec(partSpec);
    if (partSpec) {
      setFormData(prev => ({
        ...prev,
        part_no: partSpec.part_no,
        model_code: partSpec.model_code,
        target_cycle_time: partSpec.cycle_time_sec?.toString() || '',
      }));
    } else {
      // Do not clear part_no here, so user can type a new one
    }
  };

  const handleNewPartCreated = (newPart: PartSpec) => {
    // After a new part is created, select it in the autocomplete
    setSelectedPartSpec(newPart);
    handlePartSpecChange(newPart);
    setShowAddPartModal(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const createData = {
        ...formData,
        part_no: selectedPartSpec?.part_no || formData.part_no, // Ensure part_no is from selected spec
        target_cycle_time: formData.target_cycle_time ? Math.round(parseFloat(formData.target_cycle_time)) : null,
      };

      if (!createData.part_no) {
        toast.error(t('required_error'));
        setLoading(false);
        return;
      }

      await api.post('/injection/setup/', createData);

      toast.success(t('setup.create_success'));
      onClose();
      if (onSuccess) onSuccess();
    } catch (error: any) {
      const data = error?.response?.data;
      let msg = t('save_fail');

      if (data && typeof data === 'object') {
        const keys = Object.keys(data);
        if (keys.length > 0) {
          const firstKey = keys[0];
          const val = data[firstKey];
          msg = `${firstKey}: ${Array.isArray(val) ? val[0] : val}`;
        }
      } else if (error?.message) {
        msg = error.message;
      }

      setError(String(msg));
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6 w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-semibold text-gray-900">
              {t('setup.new_setup_title')}
            </h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-2xl font-bold"
            >
              ×
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('setup.machine_no')} *
                </label>
                <input
                  type="number"
                  value={formData.machine_no}
                  onChange={(e) => handleInputChange('machine_no', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                  placeholder={t('setup.machine_no_placeholder')}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Part No. *
                </label>
                <Autocomplete
                  options={partSpecResults}
                  getOptionLabel={(option) => (option as any).isAddNew ? (option as any).part_no : option.part_no}
                  onInputChange={(_, value) => setPartNoQuery(value)}
                  onChange={(_, value) => {
                    if (value && (value as any).isAddNew) {
                      setShowAddPartModal(true);
                    } else {
                      handlePartSpecChange(value as PartSpec | null);
                    }
                  }}
                  value={selectedPartSpec}
                  loading={isLoadingPartSpecs}
                  filterOptions={(options, state) => {
                    const filtered = options.filter((option) =>
                      option.part_no.toLowerCase().includes(state.inputValue.toLowerCase())
                    );
                    if (filtered.length === 0 && state.inputValue !== '') {
                      filtered.push({
                        isAddNew: true,
                        part_no: state.inputValue,
                      } as any);
                    }
                    return filtered;
                  }}
                  renderOption={(props, option) => {
                    if ((option as any).isAddNew) {
                      return (
                        <li {...props} className="bg-green-50 hover:bg-green-100 border-t border-green-200">
                          <div className="flex items-center justify-center gap-2 text-green-700 font-medium py-2 text-sm">
                            <Plus className="h-3 w-3" />
                            <span>"{(option as any).part_no}" {t('add_new_part_prompt')}</span>
                          </div>
                        </li>
                      );
                    }
                    return <li {...props}>{option.part_no}</li>;
                  }}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      placeholder={t('setup.part_no_placeholder')}
                      required={!selectedPartSpec}
                    />
                  )}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Model *
                </label>
                <input
                  type="text"
                  value={formData.model_code}
                  onChange={(e) => handleInputChange('model_code', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                  placeholder={t('setup.model_code_placeholder')}
                  disabled
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('setup.target_cycle_time')} *
                </label>
                <input
                  type="number"
                  min="1"
                  value={formData.target_cycle_time}
                  onChange={(e) => handleInputChange('target_cycle_time', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                  placeholder="0"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t('setup.note')}
              </label>
              <textarea
                value={formData.note}
                onChange={(e) => handleInputChange('note', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                rows={3}
                placeholder={t('setup.note_placeholder')}
              />
            </div>

            {error && (
              <div className="p-3 bg-red-100 border border-red-400 rounded">
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4">
              <Button
                type="button"
                variant="secondary"
                onClick={onClose}
                disabled={loading}
              >
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={loading}
              >
                {loading ? t('setup.saving') : t('save')}
              </Button>
            </div>
          </form>
        </div>
      </div>
      <NewPartSpecModal
        isOpen={showAddPartModal}
        onClose={() => setShowAddPartModal(false)}
        onSuccess={handleNewPartCreated}
        initialPartNo={partNoQuery}
      />
    </>
  );
}
